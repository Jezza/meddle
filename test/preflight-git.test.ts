import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { ensureDataDirs, loadConfig } from "../src/config";
import { preflightCommand } from "../src/update/node";

test("update-preflight refuses a node whose git is older than synced scopes need, before the swap", async () => {
  const home = await mkdtemp("/tmp/meddle-preflight-");
  const path = process.env.PATH;
  try {
    // A git that says it is Apple's 2.39.
    await writeFile(`${home}/git`, '#!/bin/sh\necho "git version 2.39.5 (Apple Git-154)"\n');
    await chmod(`${home}/git`, 0o755);
    const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
    await ensureDataDirs(cfg);
    process.env.PATH = `${home}:${path}`;
    await expect(preflightCommand(cfg)).rejects.toThrow("meddle needs git 2.43 or later (found git version 2.39.5 (Apple Git-154))");
  } finally {
    process.env.PATH = path;
    await rm(home, { recursive: true, force: true });
  }
});
