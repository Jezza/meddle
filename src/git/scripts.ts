// The files git runs on meddle's behalf: the `git-remote-meddle` remote helper wrapper and the `update` hook of the
// `receive-pack` serving a peer's push.
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
 * Writes `<data>/bin/git-remote-meddle`: a `#!/bin/sh` script that execs this meddle (this bun and the checkout's
 * `src/cli.ts`, or the compiled binary itself) with `git-remote "$@"`. Rewritten only when its content changed.
 */
export async function writeHelperWrapper(cfg: NodeConfig): Promise<string> {
  const cli = resolve(import.meta.dir, "../cli.ts");
  // Inside a compiled binary `import.meta.dir` names a virtual directory: the binary is the cli.
  const command = existsSync(cli) ? `${shq(process.execPath)} ${shq(cli)}` : shq(process.execPath);
  return writeScript(paths(cfg).binHelper, `#!/bin/sh\n# Written by meddle: git's remote helper for meddle:// remotes.\nexec ${command} git-remote "$@"\n`);
}

const UPDATE_HOOK = `#!/bin/sh
# Written by meddle: what a peer may push here. $1 is the ref, $2 the old object id, $3 the new one.
ref="$1"
case "$3" in
  *[!0]*) ;;
  *) echo "meddle: deleting $ref is not accepted here" >&2; exit 1 ;;
esac
case "$MEDDLE_REPO_KIND:$ref" in
  project:refs/heads/meddle/task/*) exit 0 ;;
  memory:refs/heads/memory) exit 0 ;;
esac
echo "meddle: ref $ref is not accepted here" >&2
exit 1
`;

/**
 * Writes `<data>/git-hooks/update`: it refuses deletions and admits only `refs/heads/meddle/task/*` into a project
 * repo and `refs/heads/memory` into a memory repo (`MEDDLE_REPO_KIND`), refusing every other ref with
 * `meddle: ref <ref> is not accepted here`.
 */
export async function writeUpdateHook(cfg: NodeConfig): Promise<string> {
  return writeScript(paths(cfg).hookUpdate, UPDATE_HOOK);
}
