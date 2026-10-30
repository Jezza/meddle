import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export class JjError extends Error {
  constructor(
    public args: string[],
    public code: number,
    public stderr: string,
  ) {
    super(`jj ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`);
    this.name = "JjError";
  }
}

export async function jj(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["jj", "--no-pager", "--color", "never", ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new JjError(args, code, stderr);
  return stdout;
}

export async function isJjRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".jj"))).isDirectory();
  } catch {
    return false;
  }
}

export async function initColocated(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await jj(["git", "init", "--colocate"], dir);
}

export async function cloneColocated(url: string, dir: string): Promise<void> {
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  await jj(["git", "clone", "--colocate", url, dir], parent);
}

export async function workspaceAdd(repo: string, name: string, path: string, revision: string): Promise<void> {
  await jj(["workspace", "add", "--colocate", "--name", name, "-r", revision, path], repo);
}

export async function workspaceForget(repo: string, name: string): Promise<void> {
  await jj(["workspace", "forget", name], repo);
}

export async function bookmarkSet(repo: string, name: string, revision: string): Promise<void> {
  await jj(["bookmark", "set", name, "-r", revision, "--allow-backwards"], repo);
}

export async function bookmarkDelete(repo: string, name: string): Promise<void> {
  await jj(["bookmark", "delete", `exact:${name}`], repo);
}

export async function changeId(workspace: string): Promise<string> {
  return (await jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], workspace)).trim();
}

export async function trunkRevset(repo: string): Promise<string> {
  const out = await jj(["log", "-r", "trunk()", "--no-graph", "-T", "change_id"], repo);
  return out.trim() ? "trunk()" : "root()";
}
