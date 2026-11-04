// test/title.test.ts — the one-off Claude Code query that names a new task.
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { askTitle } from "../src/engine/title";

const REPLAY = `${import.meta.dir}/fake-claude/replay.ts`;

async function cfg() {
  const home = await mkdtemp("/tmp/meddle-title-");
  return loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
}

test("askTitle answers the reply of its one query", async () => {
  const title = await askTitle("Reply with the single word ok.", {
    cfg: await cfg(),
    token: "tok",
    claudePath: REPLAY,
    extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
  });
  expect(title).toBe("ok");
});

test("askTitle answers null when the query fails or takes too long", async () => {
  const failing = await askTitle("hi", { cfg: await cfg(), token: "tok", claudePath: REPLAY, extraEnv: { MEDDLE_FIXTURE: "/nonexistent" } });
  expect(failing).toBeNull();
  const started = Date.now();
  const slow = await askTitle("hi", {
    cfg: await cfg(),
    token: "tok",
    claudePath: REPLAY,
    extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`, MEDDLE_FIXTURE_STALL: "1" },
    timeoutMs: 500,
  });
  expect(slow).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
});
