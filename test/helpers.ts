// test/helpers.ts — shared fixtures for tests that drive a whole node against the replayer.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import type { Database } from "bun:sqlite";
import { initColocated, jj } from "../src/jj";
import { loadOrCreateIdentity } from "../src/pool/identity";
import type { PoolRuntime } from "../src/pool/runtime";
import { addProjectFromFolder } from "../src/projects/project";
import { resolveStarts } from "../src/projects/starts";
import { openDb } from "../src/store/db";
import { newId } from "../src/store/records";
import { TaskRunner, type RunnerHooks } from "../src/tasks/durable";
import type { TaskManifest } from "../src/tasks/manifest";
import { openHarness } from "../src/tasks/harness";
import { addToken } from "../src/token";

export const replay = `${import.meta.dir}/fake-claude/replay.ts`;

/**
 * A node in a temp home: data dirs, task root, database, its pool identity (the key a later `startPool` loads; `id`), one
 * project `a` added from the colocated folder `<home>/a` with this node as its home (one commit, `init`, bookmarked
 * `main`, the project's default branch: a task of it starts on `init`; the project's repo is its service repo),
 * a token (`options.token`, default `"tok"`; `null` adds none), and a Harness with a TaskRunner that runs Claude Code
 * turns from the `fixture` recording (a name in `test/fixtures`, or an absolute path). `extraEnv` is added to the
 * environment the config is read from; its `MEDDLE_FIXTURE_*` names (`_MEMORY`, `_STALL`, `_BY_TOKEN`, `_RESULTS_MS`,
 * `_TOOL_USE`, …) also reach the stand-in Claude Code. `log` receives the runner's log lines (default
 * `console.error`); `hooks` are the runner's test hooks.
 */
export async function setupNode(
  fixture = "hello.jsonl",
  extraEnv: Record<string, string> = {},
  options: { log?: (line: string) => void; hooks?: RunnerHooks; token?: string | null } = {},
) {
  const home = await mkdtemp("/tmp/meddle-node-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t`, ...extraEnv });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const folder = `${home}/a`;
  await initColocated(folder);
  await writeFile(`${folder}/README`, "a\n");
  await jj(["commit", "-m", "init"], folder, cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], folder, cfg);
  const { id } = await loadOrCreateIdentity(cfg);
  const project = await addProjectFromFolder(cfg, db, folder, id, "a");
  const token = options.token === undefined ? "tok" : options.token;
  if (token !== null) await addToken(cfg, db, token, { setBy: id });
  const harness = await openHarness(cfg, createRegistry());
  const runner = new TaskRunner(cfg, db, harness.harness, {
    claudePath: replay,
    claudeRuntime: "bun",
    extraEnv: {
      MEDDLE_FIXTURE: fixture.startsWith("/") ? fixture : `${import.meta.dir}/fixtures/${fixture}`,
      // The stand-in's own settings (`MEDDLE_FIXTURE_MEMORY`, `_STALL`, `_BY_TOKEN`, `_RESULTS_MS`, `_TOOL_USE`, …).
      ...Object.fromEntries(Object.entries(extraEnv).filter(([name]) => name.startsWith("MEDDLE_FIXTURE_"))),
    },
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return { home, cfg, db, id, project, harness, runner };
}

/**
 * Creates a task of `projectIds` on `node` itself, as `NodeObject.createTask` does there without placement: a new id,
 * each project's start resolved on its home (`resolveStarts`: here, or over `node.pool`), then `node.runner.create`.
 */
export async function createTask(
  node: { cfg: ReturnType<typeof loadConfig>; db: Database; id: string; runner: TaskRunner; pool?: PoolRuntime },
  input: { title: string; projectIds: string[] },
): Promise<TaskManifest> {
  const taskId = newId();
  const deps = { cfg: node.cfg, db: node.db, selfId: node.id, ...(node.pool === undefined ? {} : { pool: node.pool }) };
  const starts = await resolveStarts(deps, taskId, input.projectIds.map((id) => ({ id })));
  return node.runner.create({ title: input.title, taskId, starts });
}

/**
 * Writes a copy of `test/fixtures/hello.jsonl` whose `result` ended with `subtype` (an error, `is_error` set) to a temp
 * file and returns its path.
 */
export async function errorResultFixture(subtype = "error_during_execution"): Promise<string> {
  const lines = (await readFile(`${import.meta.dir}/fixtures/hello.jsonl`, "utf8")).split("\n").filter(Boolean).map((l) => {
    const entry = JSON.parse(l) as { dir: string; line?: string };
    if (entry.dir !== "out" || entry.line === undefined) return l;
    const frame = JSON.parse(entry.line) as { type?: string };
    if (frame.type !== "result") return l;
    return JSON.stringify({ ...entry, line: JSON.stringify({ ...frame, subtype, is_error: true, errors: [] }) });
  });
  const file = `${await mkdtemp("/tmp/meddle-fixture-")}/error.jsonl`;
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

export const repoRoot = `${import.meta.dir}/..`;

/**
 * `env` on top of this process's environment, without anything that would point a meddle child at the real
 * `~/.claude` or at another node (`CLAUDE_CONFIG_DIR`, any `MEDDLE_*`). Unless `env` sets `PATH` itself, its
 * `MEDDLE_DATA_DIR`'s `bin` (where `serve` writes `git-remote-meddle`) goes first on `PATH`, as the README has a user
 * set it: `project add` and `checkout` refuse without the helper there.
 */
export function childEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "CLAUDE_CONFIG_DIR" || key.startsWith("MEDDLE_")) continue;
    out[key] = value;
  }
  if (env.PATH === undefined && env.MEDDLE_DATA_DIR !== undefined) {
    out.PATH = [`${env.MEDDLE_DATA_DIR}/bin`, ...(out.PATH === undefined ? [] : [out.PATH])].join(delimiter);
  }
  return { ...out, ...env };
}

/** Runs `bun run src/cli.ts <args>` in `cwd` (the repo root by default) with `env` (see `childEnv`) and collects its output. */
export async function meddle(args: string[], env: Record<string, string>, cwd = repoRoot) {
  const proc = Bun.spawn(["bun", "run", `${repoRoot}/src/cli.ts`, ...args], {
    cwd,
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

/** A port on 127.0.0.1 that nothing listens on (it was free a moment ago). */
export async function closedPort(): Promise<number> {
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = free.port!;
  await free.stop(true);
  return port;
}

const SERVE_DEADLINE_MS = 15_000;

/**
 * Starts `meddle serve` with `env` and resolves once it prints its `dashboard at` line, with its node id (from the
 * `node <id>` line before it), the bound port and the dashboard's URL; after 15 s without one it stops the child and rejects with its stderr. `stop` sends SIGTERM
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
  const started = await new Promise<{ id: string; url: string }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`meddle serve printed no dashboard line in ${SERVE_DEADLINE_MS} ms:\n`)), SERVE_DEADLINE_MS);
    let stdout = "";
    const decoder = new TextDecoder();
    (async () => {
      for await (const chunk of proc.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        const match = /^node ([0-9a-f]{64})\ndashboard at (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(stdout);
        if (match) {
          clearTimeout(deadline);
          resolve({ id: match[1]!, url: match[2]! });
        }
      }
      clearTimeout(deadline);
      reject(new Error(`meddle serve exited before its dashboard was up:\n${stdout}`));
    })().catch(reject);
  }).catch(async (err: Error) => {
    await stop();
    throw new Error(`${err.message}${stderr}`);
  });
  const { id, url } = started;
  return { id, port: Number(new URL(url).port), url, stop, stderr: () => stderr };
}
