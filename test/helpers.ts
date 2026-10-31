// test/helpers.ts — shared fixtures for tests that drive a whole node against the replayer.
import { mkdtemp, mkdir } from "node:fs/promises";
import { createRegistry } from "@earendil-works/pi-durable";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import { initColocated } from "../src/jj";
import { addProjectFromFolder } from "../src/projects/project";
import { openDb } from "../src/store/db";
import { TaskRunner } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { setToken } from "../src/token";

export const replay = `${import.meta.dir}/fake-claude/replay.ts`;

/**
 * A node in a temp home: data dirs, task root, database, one colocated project added from a folder,
 * a token, and a Harness with a TaskRunner that runs Claude Code turns from the `fixture` recording.
 */
export async function setupNode(fixture = "hello.jsonl") {
  const home = await mkdtemp("/tmp/meddle-node-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const folder = `${home}/a`;
  await initColocated(folder);
  const project = await addProjectFromFolder(cfg, db, folder, "a");
  await setToken(cfg, "tok");
  const harness = await openHarness(cfg, createRegistry());
  const runner = new TaskRunner(cfg, db, harness.harness, {
    claudePath: replay,
    claudeRuntime: "bun",
    extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/${fixture}` },
  });
  return { home, cfg, db, project, harness, runner };
}
