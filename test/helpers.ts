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

export const repoRoot = `${import.meta.dir}/..`;

/**
 * `env` on top of this process's environment, without anything that would point a meddle child at the real
 * `~/.claude` or at another node (`CLAUDE_CONFIG_DIR`, any `MEDDLE_*`).
 */
export function childEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "CLAUDE_CONFIG_DIR" || key.startsWith("MEDDLE_")) continue;
    out[key] = value;
  }
  return { ...out, ...env };
}

/** Runs `bun run src/cli.ts <args>` in the repo root with `env` (see `childEnv`) and collects its output. */
export async function meddle(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const SERVE_DEADLINE_MS = 15_000;

/**
 * Starts `meddle serve` with `env` and resolves once it prints its `dashboard at` line, with the bound port and
 * the dashboard's URL; after 15 s without one it stops the child and rejects with its stderr. `stop` sends SIGTERM
 * (SIGKILL 15 s later if the child is still running) and resolves with the exit code; `stderr` is what it printed so far.
 */
export async function startServe(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  const drainErr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
  })();
  const stop = async () => {
    proc.kill("SIGTERM");
    // A serve hung in startup only acts on SIGTERM once startup is done; it gets SIGKILL after a while.
    const kill = setTimeout(() => proc.kill("SIGKILL"), SERVE_DEADLINE_MS);
    const code = await proc.exited;
    clearTimeout(kill);
    await drainErr;
    return code;
  };
  const url = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`meddle serve printed no dashboard line in ${SERVE_DEADLINE_MS} ms:\n`)), SERVE_DEADLINE_MS);
    let stdout = "";
    const decoder = new TextDecoder();
    (async () => {
      for await (const chunk of proc.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        const match = /^dashboard at (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(stdout);
        if (match) {
          clearTimeout(deadline);
          resolve(match[1]!);
        }
      }
      clearTimeout(deadline);
      reject(new Error(`meddle serve exited before its dashboard was up:\n${stdout}`));
    })().catch(reject);
  }).catch(async (err: Error) => {
    await stop();
    throw new Error(`${err.message}${stderr}`);
  });
  return { port: Number(new URL(url).port), url, stop, stderr: () => stderr };
}
