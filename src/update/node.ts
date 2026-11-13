// src/update/node.ts — what an update needs of the machine: whether this node can be updated at all, the preflight
// that proves a staged binary runs here (and fetches the Claude Code it pins), and the restart under systemd.
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NodeConfig } from "../config";
import { ensureClaude } from "../claude-code";
import { embedded } from "../embedded";
import { buildInfo, CHECKOUT_BUILD, type BuildInfo } from "./build";
import type { UpdateFiles } from "./files";

/** The exit status that asks systemd to start the node again: the swap, a rollback, or a new build past its health deadline. */
export const RESTART_STATUS = 75;

/** The marker of the guard in the unit: `meddle service install` writes it, and a unit without it cannot roll back. */
export const GUARD_COMMAND = "update-guard";

/** The user unit `meddle service install` writes. */
export function unitPath(home = homedir()): string {
  return join(home, ".config/systemd/user/meddle.service");
}

/**
 * Why this node cannot be updated, or null when it can: it runs from a checkout; the directory of its binary is not
 * writable by this user (the swap renames into it); it is not run by systemd (nothing would start it again); its unit
 * does not start this binary (installed from another one: the swap would replace a binary the unit does not run); or
 * its unit has no guard for this binary's `.previous` (`meddle service install` from before updates, or from another
 * binary: run it again), so a new binary that cannot start could not be rolled back.
 */
export async function updateBlocked(build: BuildInfo, files: UpdateFiles, env: Record<string, string | undefined> = process.env, unit = unitPath()): Promise<string | null> {
  if (build.buildId === CHECKOUT_BUILD) return "it runs from a checkout";
  const dir = dirname(files.exec);
  try {
    await access(dir, constants.W_OK);
  } catch {
    return `cannot replace ${files.exec}: ${dir} is not writable by this user`;
  }
  if (env.INVOCATION_ID === undefined) return "it is not run by systemd (meddle service install), so nothing would start it again";
  const lines = (await readFile(unit, "utf8").catch(() => "")).split("\n").map((line) => line.trim());
  if (!lines.includes(`ExecStart=${files.exec} serve`)) return `its service unit does not run ${files.exec}: run meddle service install again from it`;
  // A path the guard line cannot hold (a quote in it) has a comment for a guard: no guard.
  const guard = guardLine(files.exec);
  if (guard.startsWith("#") || !lines.includes(guard)) return "its service unit has no update guard for this binary: run meddle service install again";
  return null;
}

/** How long a preflight may take: it may download Claude Code (~140 MB). */
const PREFLIGHT_MS = 20 * 60_000;

/**
 * Runs the staged binary's preflight (`<binary> update-preflight`, with this node's environment): it must run on this
 * machine, report `build` as its build, and have installed the Claude Code it pins. Rejects with why, and the end of
 * what it printed.
 */
export async function runPreflight(path: string, build: string): Promise<void> {
  const proc = Bun.spawn([path, "update-preflight"], { stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill(), PREFLIGHT_MS);
  let code: number;
  let out: string;
  let err: string;
  try {
    [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  } catch (e) {
    throw new Error(`it could not run here: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const tail = (text: string) => text.trim().split("\n").slice(-5).join("\n");
  if (code !== 0) throw new Error(`it exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}: ${tail(err) || tail(out)}`);
  let reported: { buildId?: unknown } = {};
  try {
    reported = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { buildId?: unknown };
  } catch {
    // Reported below as no build.
  }
  if (reported.buildId !== build) throw new Error(`it reports build ${String(reported.buildId)}, not ${build}`);
}

/**
 * `meddle update-preflight`, run by a node on a staged binary before it swaps: proves this binary runs here, installs
 * the Claude Code it pins (downloaded, or from the binary) into the data directory, and prints its build as JSON.
 */
export async function preflightCommand(cfg: NodeConfig): Promise<number> {
  const packed = embedded();
  if (packed === null) throw new Error("update-preflight runs only in a binary `bun run build` made");
  await ensureClaude(packed.claudeCode, cfg.dataDir, {
    registry: cfg.npmRegistry,
    embedded: packed.claude,
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify(buildInfo()));
  return 0;
}

/**
 * The unit's guard line for the binary at `exec` (`ExecStartPre=`, run as `<exec>.previous update-guard` when that file
 * is there, failures ignored so that `serve` still starts), or a comment saying why there is none: a checkout (`exec`
 * null) is never updated, and a path with a quote or backslash in it cannot be put in the shell line safely.
 */
export function guardLine(exec: string | null): string {
  if (exec === null) return "# (none: a checkout is never updated by the pool)";
  if (/['"\\`\n]/.test(exec)) return "# (none: the binary's path has a quote or backslash in it; updates refuse this node)";
  // systemd reads `%` as a specifier and `$` as a variable: both doubled.
  const previous = `${exec}.previous`.replaceAll("%", "%%").replaceAll("$", "$$$$");
  return `ExecStartPre=-/bin/sh -c 'if [ -x "${previous}" ]; then exec "${previous}" ${GUARD_COMMAND}; fi'`;
}
