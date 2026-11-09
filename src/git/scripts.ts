// The files git runs on meddle's behalf: the `git-remote-meddle` remote helper wrapper and the `pre-receive` hook of
// every `receive-pack` this node serves.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { NodeConfig } from "../config";
import { paths } from "../paths";

/** `text` quoted for sh. */
function shq(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Writes `content` to `file` (mode 755) unless it already holds exactly that; the directory is created. */
async function writeScript(file: string, content: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== content) await writeFile(file, content, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

/**
 * How a script runs this meddle with `entry`'s command: this bun and the checkout's `src/git/<entry>` (which loads only
 * what that command needs), or, inside the compiled binary (where `import.meta.dir` names a virtual directory), the
 * binary itself.
 */
function meddleCommand(entry: string): string {
  const file = resolve(import.meta.dir, entry);
  return existsSync(file) ? `${shq(process.execPath)} ${shq(file)}` : shq(process.execPath);
}

/**
 * Writes `<data>/bin/git-remote-meddle`: a `#!/bin/sh` script that execs this meddle (this bun and the checkout's
 * `src/git/remote-main.ts`, which loads only the helper, or the compiled binary itself) with `git-remote "$@"`.
 * Rewritten only when its content changed.
 */
export async function writeHelperWrapper(cfg: NodeConfig): Promise<string> {
  return writeScript(paths(cfg).binHelper, `#!/bin/sh\n# Written by meddle: git's remote helper for meddle:// remotes.\nexec ${meddleCommand("remote-main.ts")} git-remote "$@"\n`);
}

/**
 * Writes `<data>/checkout-hooks/pre-receive`: a `#!/bin/sh` script that execs this meddle (this bun and the checkout's
 * `src/git/pre-receive.ts`, or the compiled binary itself) with `git-pre-receive`, which reads git's lines on its stdin
 * and refuses the whole push or admits it. Its own directory: git runs every hook of a `core.hooksPath`. Rewritten only
 * when its content changed.
 */
export async function writePreReceiveHook(cfg: NodeConfig): Promise<string> {
  return writeScript(paths(cfg).hookPreReceive, `#!/bin/sh\n# Written by meddle: the gate of a push to this node.\nexec ${meddleCommand("pre-receive.ts")} git-pre-receive\n`);
}
